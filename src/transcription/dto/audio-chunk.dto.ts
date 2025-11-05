export interface AudioChunkDto {
  chunk_base64: string;
  language: string;
  terms?: string[];
  transcriptionId: string;
}
