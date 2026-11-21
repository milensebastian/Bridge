import { createServer } from 'node:http';
import { createRelay } from './relay';
const server = createServer((request, response) => { response.writeHead(request.url === '/health' ? 200 : 404); response.end(request.url === '/health' ? 'ok' : 'Not found'); });
const origins = process.env.ALLOWED_ORIGINS?.split(',').filter(Boolean) ?? [];
if (process.env.NODE_ENV === 'production' && !origins.length) throw Error('ALLOWED_ORIGINS is required in production');
createRelay(server, origins);
server.listen(Number(process.env.PORT ?? 8787), '0.0.0.0', () => console.log('Signaling relay listening on port ' + (process.env.PORT ?? 8787)));
