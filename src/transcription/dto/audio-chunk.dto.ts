export interface AudioChunkDto {
  chunk: Uint8Array;
  language: string;
  terms?: string[];
  transcriptionId: string;
}
