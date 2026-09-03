import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserDocument = User & Document;

export class PasskeyCredential {
  credentialId: string;      // Base64URL encoded
  publicKey: string;         // Base64URL encoded
  counter: number;           // Anti-replay counter
  transports: string[];      // ['internal', 'hybrid', etc.]
  deviceName?: string;       // e.g., "iPhone 15"
  /// Identifica QUÉ guarda la llave: el llavero de iCloud, el gestor de
  /// Google, 1Password. El nombre del dispositivo lo pone el usuario y no
  /// dice dónde vive la credencial.
  aaguid?: string;
  createdAt: Date;
  lastUsedAt?: Date;
}

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
    /// Pares que generan aviso: "NEXO/USDT", "NEXO/BTC". Es la unidad
    /// correcta porque un activo cotiza contra varias monedas y no valen lo
    /// mismo. Ausente significa "nunca eligió pares" y se traduce desde
    /// alertAssets; vacío es una elección legítima —no quiero nada— y se
    /// respeta.
    alertPairs?: string[];

    /// Selección vieja, por activo. Se conserva para traducir la preferencia
    /// de quien todavía no eligió pares (la app publicada manda esto).
    alertAssets?: string[];
  };

  @Prop({ type: [Object], default: [] })
  passkeys: PasskeyCredential[];

  @Prop()
  currentChallenge?: string;

  @Prop()
  challengeExpiresAt?: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.index({ email: 1 });
