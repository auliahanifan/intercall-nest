import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { Server } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class TranscriptionGateway {
  @WebSocketServer()
  server: Server;

  @SubscribeMessage('audio_chunk')
  handleAudioChunk(@MessageBody() data: { chunk: any; language: string }) {
    console.log(data.language);
    return from([1, 2, 3]).pipe(
      map((item) => ({ event: 'events', data: item })),
    );
  }
}
