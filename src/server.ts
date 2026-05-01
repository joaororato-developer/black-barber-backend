import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import * as dotenv from 'dotenv';
import path from 'path';

import routes from './routes';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();

app.use(helmet());

app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
}));

app.use(express.json());
app.use(cookieParser());

app.use(routes);

const PORT = process.env.PORT || 3333;

app.listen(PORT, () => {
  console.log(`Backend Server is running in ${process.env.NODE_ENV} mode securely on port ${PORT} `);
});
