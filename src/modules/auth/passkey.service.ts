import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/types';
import { UsersService } from '../users/users.service';
import { PasskeyCredential } from '../users/schemas/user.schema';
import { TokenResponseDto } from './dto/token-response.dto';

@Injectable()
export class PasskeyService {
  private readonly rpName = 'Exchange Monitor';
  private readonly rpId: string;
  private readonly origin: string;
  private readonly challengeTimeout = 60000; // 60 seconds

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.rpId = this.configService.get<string>('PASSKEY_RP_ID') || 'localhost';
    this.origin = this.configService.get<string>('PASSKEY_ORIGIN') || 'http://localhost:3000';
  }

  async generateRegistrationChallenge(userId: string): Promise<{
    options: any;
    challenge: string;
  }> {
    const user = await this.usersService.findById(userId);

    const existingCredentials = (user.passkeys || []).map((passkey) => ({
      id: Buffer.from(passkey.credentialId, 'base64url'),
      type: 'public-key' as const,
      transports: passkey.transports as AuthenticatorTransportFuture[],
    }));

    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpId,
      userID: user._id.toString(),
      userName: user.email,
      userDisplayName: `${user.firstName} ${user.lastName}`,
      attestationType: 'none',
      excludeCredentials: existingCredentials,
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
        authenticatorAttachment: 'platform',
      },
      timeout: this.challengeTimeout,
    });

    const expiresAt = new Date(Date.now() + this.challengeTimeout);
    await this.usersService.setPasskeyChallenge(userId, options.challenge, expiresAt);

    return {
      options,
      challenge: options.challenge,
    };
  }

  async verifyRegistration(
    userId: string,
    response: RegistrationResponseJSON,
    deviceName?: string,
  ): Promise<PasskeyCredential> {
    const user = await this.usersService.findById(userId);

    if (!user.currentChallenge) {
      throw new BadRequestException('No registration challenge found');
    }

    if (user.challengeExpiresAt && new Date() > user.challengeExpiresAt) {
      await this.usersService.clearPasskeyChallenge(userId);
      throw new BadRequestException('Registration challenge expired');
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: user.currentChallenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
      });
    } catch (error) {
      await this.usersService.clearPasskeyChallenge(userId);
      throw new BadRequestException(`Verification failed: ${error.message}`);
    }

    if (!verification.verified || !verification.registrationInfo) {
      await this.usersService.clearPasskeyChallenge(userId);
      throw new BadRequestException('Registration verification failed');
    }

    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;

    const newCredential: PasskeyCredential = {
      credentialId: Buffer.from(credentialID).toString('base64url'),
      publicKey: Buffer.from(credentialPublicKey).toString('base64url'),
      counter: counter,
      transports: response.response.transports || ['internal'],
      deviceName: deviceName || 'Unknown Device',
      createdAt: new Date(),
    };

    await this.usersService.addPasskeyCredential(userId, newCredential);
    await this.usersService.clearPasskeyChallenge(userId);

    return newCredential;
  }

  async generateAuthChallenge(email?: string): Promise<{
    options: any;
    challenge: string;
  }> {
    // If email is provided, generate challenge for specific user
    if (email) {
      const user = await this.usersService.findByEmail(email);
      if (!user) {
        throw new NotFoundException('User not found');
      }

      if (!user.passkeys || user.passkeys.length === 0) {
        throw new BadRequestException('No passkeys registered for this user');
      }

      const allowCredentials = user.passkeys.map((passkey) => ({
        id: Buffer.from(passkey.credentialId, 'base64url'),
        type: 'public-key' as const,
        transports: passkey.transports as AuthenticatorTransportFuture[],
      }));

      const options = await generateAuthenticationOptions({
        rpID: this.rpId,
        allowCredentials,
        userVerification: 'required',
        timeout: this.challengeTimeout,
      });

      const expiresAt = new Date(Date.now() + this.challengeTimeout);
      await this.usersService.setPasskeyChallenge(user._id.toString(), options.challenge, expiresAt);

      return {
        options,
        challenge: options.challenge,
      };
    }

    // Discoverable credential flow - no email required
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: [], // Empty = browser shows all available passkeys
      userVerification: 'required',
      timeout: this.challengeTimeout,
    });

    // Store challenge globally (we'll validate it during verification)
    await this.usersService.storeGlobalChallenge(options.challenge, new Date(Date.now() + this.challengeTimeout));

    return {
      options,
      challenge: options.challenge,
    };
  }

  async verifyAuthentication(
    email: string | undefined,
    response: AuthenticationResponseJSON,
  ): Promise<TokenResponseDto> {
    const credentialId = response.id;
    let user;
    let expectedChallenge: string;

    if (email) {
      // Traditional flow with email
      user = await this.usersService.findByEmail(email);
      if (!user) {
        throw new UnauthorizedException('Invalid credentials');
      }

      if (!user.currentChallenge) {
        throw new BadRequestException('No authentication challenge found');
      }

      if (user.challengeExpiresAt && new Date() > user.challengeExpiresAt) {
        await this.usersService.clearPasskeyChallenge(user._id.toString());
        throw new BadRequestException('Authentication challenge expired');
      }

      expectedChallenge = user.currentChallenge;
    } else {
      // Discoverable credential flow - find user by credential ID
      user = await this.usersService.findByPasskeyCredentialId(credentialId);
      if (!user) {
        throw new UnauthorizedException('Credential not found');
      }

      // Get and validate global challenge
      const globalChallenge = await this.usersService.getGlobalChallenge();
      if (!globalChallenge) {
        throw new BadRequestException('No authentication challenge found');
      }

      if (globalChallenge.expiresAt && new Date() > globalChallenge.expiresAt) {
        await this.usersService.clearGlobalChallenge();
        throw new BadRequestException('Authentication challenge expired');
      }

      expectedChallenge = globalChallenge.challenge;
    }

    const credential = user.passkeys?.find(
      (p) => p.credentialId === credentialId,
    );

    if (!credential) {
      throw new UnauthorizedException('Credential not found');
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        authenticator: {
          credentialID: Buffer.from(credential.credentialId, 'base64url'),
          credentialPublicKey: Buffer.from(credential.publicKey, 'base64url'),
          counter: credential.counter,
          transports: credential.transports as AuthenticatorTransportFuture[],
        },
        requireUserVerification: true,
      });
    } catch (error) {
      if (email) {
        await this.usersService.clearPasskeyChallenge(user._id.toString());
      } else {
        await this.usersService.clearGlobalChallenge();
      }
      throw new UnauthorizedException(`Authentication failed: ${error.message}`);
    }

    if (!verification.verified) {
      if (email) {
        await this.usersService.clearPasskeyChallenge(user._id.toString());
      } else {
        await this.usersService.clearGlobalChallenge();
      }
      throw new UnauthorizedException('Authentication verification failed');
    }

    // Update counter to prevent replay attacks
    await this.usersService.updatePasskeyCredential(
      user._id.toString(),
      credentialId,
      {
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: new Date(),
      },
    );

    if (email) {
      await this.usersService.clearPasskeyChallenge(user._id.toString());
    } else {
      await this.usersService.clearGlobalChallenge();
    }
    await this.usersService.updateLastLogin(user._id);

    if (!user.isActive) {
      throw new UnauthorizedException('Account is inactive');
    }

    const payload = { sub: user._id.toString(), email: user.email };
    const expiresIn = this.configService.get<string>('jwt.expiresIn');

    return {
      accessToken: this.jwtService.sign(payload),
      expiresIn,
      tokenType: 'Bearer',
    };
  }

  async listPasskeys(userId: string): Promise<{
    passkeys: Array<{
      id: string;
      deviceName: string;
      createdAt: Date;
      lastUsedAt?: Date;
    }>;
  }> {
    const user = await this.usersService.findById(userId);

    return {
      passkeys: (user.passkeys || []).map((p) => ({
        id: p.credentialId,
        deviceName: p.deviceName || 'Unknown Device',
        createdAt: p.createdAt,
        lastUsedAt: p.lastUsedAt,
      })),
    };
  }

  async deletePasskey(userId: string, credentialId: string): Promise<void> {
    const user = await this.usersService.findById(userId);

    const credential = user.passkeys?.find((p) => p.credentialId === credentialId);
    if (!credential) {
      throw new NotFoundException('Passkey not found');
    }

    await this.usersService.removePasskeyCredential(userId, credentialId);
  }
}
