import { Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
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
    console.log('Connecting to MongoDB:', url.hostname);
    return cleanUri;
  } catch (e) {
    console.error('Invalid MongoDB connection string:', e.message);
    return 'mongodb://localhost/orchalite';
  }
}

@Module({
  imports: [WorkflowModule],
})
export class AppModule implements OnModuleInit, OnApplicationShutdown {
  // Tasks use models on the default mongoose connection, so that is the one we open
  async onModuleInit() {
    const { connection } = mongoose;

    // Monitor connection events (the driver reconnects on its own)
    connection.on("error", (err) => {
      console.error('MongoDB: Connection error:', err.message);
    });

    connection.on("disconnected", () => {
      console.log('MongoDB: Disconnected');
    });

    connection.on("reconnected", () => {
      console.log('MongoDB: Reconnected');
    });

    try {
      await mongoose.connect(getConnectionString(), {
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
      });
      console.log(`MongoDB: Connected to "${connection.name}" on "${connection.host}"`);
    } catch (err) {
      console.error('MongoDB: Connection failed:', err.message);
      if (err.name === 'MongoServerSelectionError') {
        console.error('Please check:');
        console.error('1. MongoDB server is running and reachable');
        console.error('2. IP address is whitelisted (Atlas)');
        console.error('3. Credentials are correct');
      }
      throw err;
    }
  }

  // Handle graceful shutdown
  async onApplicationShutdown() {
    await mongoose.disconnect();
  }
}
