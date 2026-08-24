import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3001);

const app = createApp();

app.listen(port, () => {
  console.log(`backend listening on port ${port}`);
});
