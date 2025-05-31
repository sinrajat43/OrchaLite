import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WorkflowModule } from './workflows/workflow.module';
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

function getConnectionString(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set in environment variables');
    return 'mongodb://localhost/orchalite';
  }
  try {
    const cleanUri = uri.trim();
    const url = new URL(cleanUri);
    console.log('Connecting to MongoDB Atlas:', url.hostname);
    return cleanUri;
  } catch (e) {
    console.error('Invalid MongoDB connection string:', e.message);
    return 'mongodb://localhost/orchalite';
  }
}

@Module({
  imports: [
    MongooseModule.forRoot(getConnectionString(), {
      connectionFactory: async (connection) => {
        try {
          await mongoose.connect(getConnectionString());
          const dbName = connection.name;
          const host = connection.host;
          console.log(`MongoDB: Connected to "${dbName}" on "${host}"`);
          
          // Monitor connection events
          connection.on("error", (err) => {
            console.error('MongoDB: Connection error:', err.message);
          });
          
          connection.on("disconnected", () => {
            console.log('MongoDB: Disconnected - attempting to reconnect...');
            setTimeout(() => connection.connect(), 5000);
          });

          // Handle graceful shutdown
          process.on('SIGINT', async () => {
            await connection.close();
            process.exit(0);
          });

          return connection;
        } catch (err) {
          console.error('MongoDB: Connection failed:', err.message);
          if (err.name === 'MongoServerSelectionError') {
            console.error('Please check:');
            console.error('1. MongoDB Atlas cluster is running');
            console.error('2. IP address is whitelisted');
            console.error('3. Credentials are correct');
          }
          throw err;
        }
      },
      // Essential connection options
      retryWrites: true,
      w: 'majority',
      maxPoolSize: 10,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      heartbeatFrequencyMS: 10000,
      autoIndex: process.env.NODE_ENV !== 'production',
      autoCreate: process.env.NODE_ENV !== 'production',
      connectTimeoutMS: 5000,
      family: 4,
    }),
    WorkflowModule,
  ],
})
export class AppModule {}
