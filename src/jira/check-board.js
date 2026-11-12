import '../load-local-env.js';
import { createJiraConnection } from './connection.js';

const board = await createJiraConnection().checkBoard();
console.info(JSON.stringify(board));
