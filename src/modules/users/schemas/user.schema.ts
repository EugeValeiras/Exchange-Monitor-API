import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserDocument = User & Document;

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true })
  passwordHash: string;

  @Prop({ required: true })
  firstName: string;

  @Prop({ required: true })
  lastName: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: 'user', enum: ['user', 'admin'] })
  role: string;

  @Prop()
  lastLoginAt?: Date;

  @Prop({ type: [String], default: [] })
  favoriteAssets: string[];

  @Prop({ type: [String], default: [] })
  pushTokens: string[];

  @Prop({
    type: Object,
    default: { enabled: false, priceChangeThreshold: 5 },
  })
  notificationSettings: {
    enabled: boolean;
    priceChangeThreshold: number;
    quietHoursStart?: string;
    quietHoursEnd?: string;
  };
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.index({ email: 1 });
