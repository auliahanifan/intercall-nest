export interface StartTranscriptionDto {
  language: string;
  transcriptionId: string;
  terms?: string[];
}
