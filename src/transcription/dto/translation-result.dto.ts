export class TranslationResultDto {
  text: string;
  type: 'original' | 'translation';
  language: string;
  sourceLanguage?: string;
  timestamp: Date;
  isFinal?: boolean;
  speaker?: string;
}
