import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { openAPI, organization, customSession } from 'better-auth/plugins';
import { PrismaClient } from 'generated/prisma/client'; // npm run prisma:generate

const prisma = new PrismaClient();

/**
 * Generates a URL-friendly slug from a string
 */
function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/[\s_-]+/g, '-') // Replace spaces/underscores/hyphens with single hyphen
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
}

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
  secret: process.env.BETTER_AUTH_SECRET || 'your-secret-key',
  trustedOrigins: [
    'https://intercall.segarloka.cc', // BACKEND PRODUCTION
    'https://intercallai.segarloka.cc', // FRONTEND PRODUCTION
    'http://localhost:3000', // express
    'http://localhost:8080', // vite
  ],
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 60 * 24 * 60 * 365,
    },
  },
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      accessType: 'offline',
      prompt: 'select_account consent',
    },
  },
  plugins: [
    organization({
      creatorRole: 'admin', // Set default organization creator role to admin
      organizationHooks: {
        afterCreateOrganization: async ({
          organization: org,
          user,
          member,
        }) => {
          console.log('Organization created via auth.api', {
            organizationId: org.id,
            userId: user.id,
            memberRole: member.role,
            organizationName: org.name,
          });
        },
      },
    }),
    openAPI(),
    customSession(async ({ user, session }) => {
      // Query user's first organization from Member table
      const member = await prisma.member.findFirst({
        where: { userId: { equals: user.id } },
      });

      // Query user details for onboarding status
      const userDetail = await prisma.userDetail.findUnique({
        where: { userId: user.id },
      });

      return {
        user: {
          ...user,
          activeOrganizationId: member?.organizationId ?? null,
          hasCompletedOnboarding: userDetail?.hasCompletedOnboarding ?? false,
          onboardingAnswers: userDetail?.onboardingAnswers ?? null,
        },
        session,
      };
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          try {
            console.log('New user created, setting up default organization', {
              userId: user.id,
              userName: user.name,
              userEmail: user.email,
            });

            // Check if user already has organizations
            const existingOrgs = await prisma.member.findMany({
              where: {
                userId: {
                  equals: user.id,
                },
              },
            });
            if (existingOrgs.length === 0) {
              const orgName = `${user.name || user.email}'s Default`;
              let slug = generateSlug(orgName);
              let isSlugAvailable = false;
              let slugAttempt = 0;

              // Keep regenerating slug until we find an available one
              while (!isSlugAvailable) {
                const existingOrg = await prisma.organization.findMany({
                  where: {
                    slug: {
                      equals: slug,
                    },
                  },
                });

                if (existingOrg.length === 0) {
                  isSlugAvailable = true;
                } else {
                  // Append a counter to the slug and try again
                  slugAttempt++;
                  slug = `${generateSlug(orgName)}-${slugAttempt}`;
                }
              }

              // Create organization directly in database
              const newOrg = await prisma.organization.createManyAndReturn({
                data: [
                  {
                    id: `org_${Date.now()}`,
                    name: orgName,
                    slug: slug,
                    createdAt: new Date(),
                  },
                ],
              });

              // Add user as admin member of the new organization
              if (newOrg.length > 0) {
                await prisma.member.createManyAndReturn({
                  data: [
                    {
                      id: `member_${Date.now()}`,
                      organizationId: newOrg[0].id,
                      userId: user.id,
                      role: 'admin',
                      createdAt: new Date(),
                    },
                  ],
                });

                // Create a free subscription for the new organization
                try {
                  // Get the free plan
                  const freePlan = await prisma.subscriptionPlan.findUnique({
                    where: { slug: 'free' },
                  });

                  if (freePlan) {
                    await prisma.organizationSubscription.create({
                      data: {
                        organizationId: newOrg[0].id,
                        planId: freePlan.id,
                        status: 'active',
                        currentPeriodStart: new Date(),
                        currentPeriodEnd: null, // Never expires for free tier
                        lifetimeUsageMinutes: 0,
                      },
                    });

                    console.log('Free subscription created for organization', {
                      organizationId: newOrg[0].id,
                      planId: freePlan.id,
                    });
                  }
                } catch (error) {
                  console.error('Error creating subscription for new organization:', error);
                  // Don't throw - we don't want to break the organization creation flow
                }

                console.log('Default organization created successfully', {
                  organizationId: newOrg[0].id,
                  organizationName: orgName,
                  organizationSlug: slug,
                  userId: user.id,
                });
              }
            }
          } catch (error) {
            console.error('Error creating default organization:', error);
            // Don't throw - we don't want to break the user creation flow
          }

          //return user;
        },
      },
    },
  },
});
