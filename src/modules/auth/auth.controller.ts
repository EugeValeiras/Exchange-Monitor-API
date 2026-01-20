import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { PasskeyService } from './passkey.service';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { TokenResponseDto } from './dto/token-response.dto';
import {
  RegisterPasskeyChallengeResponseDto,
  VerifyPasskeyRegistrationDto,
  PasskeyRegistrationResultDto,
  AuthPasskeyChallengeDto,
  AuthPasskeyChallengeResponseDto,
  VerifyPasskeyAuthenticationDto,
  PasskeyListResponseDto,
} from './dto/passkey.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly passkeyService: PasskeyService,
    private readonly usersService: UsersService,
  ) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({ status: 201, type: TokenResponseDto })
  @ApiResponse({ status: 409, description: 'Email already exists' })
  async register(@Body() registerDto: RegisterDto): Promise<TokenResponseDto> {
    return this.authService.register(registerDto);
  }

  @Post('login')
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, type: TokenResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() loginDto: LoginDto): Promise<TokenResponseDto> {
    return this.authService.login(loginDto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'User profile' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@Request() req) {
    const user = await this.usersService.findById(req.user.userId);
    return {
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      lastLoginAt: user.lastLoginAt,
    };
  }

  // Passkey Registration Endpoints (require JWT)
  @Post('passkey/register/challenge')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Generate passkey registration challenge' })
  @ApiResponse({ status: 200, type: RegisterPasskeyChallengeResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async generatePasskeyRegistrationChallenge(
    @Request() req,
  ): Promise<RegisterPasskeyChallengeResponseDto> {
    return this.passkeyService.generateRegistrationChallenge(req.user.userId);
  }

  @Post('passkey/register/verify')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify passkey registration and save credential' })
  @ApiResponse({ status: 201, type: PasskeyRegistrationResultDto })
  @ApiResponse({ status: 400, description: 'Verification failed' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async verifyPasskeyRegistration(
    @Request() req,
    @Body() dto: VerifyPasskeyRegistrationDto,
  ): Promise<PasskeyRegistrationResultDto> {
    const credential = await this.passkeyService.verifyRegistration(
      req.user.userId,
      dto.response,
      dto.deviceName,
    );
    return {
      success: true,
      credentialId: credential.credentialId,
      deviceName: credential.deviceName || 'Unknown Device',
      createdAt: credential.createdAt,
    };
  }

  // Passkey Authentication Endpoints (no JWT required)
  @Post('passkey/authenticate/challenge')
  @ApiOperation({ summary: 'Generate passkey authentication challenge' })
  @ApiResponse({ status: 200, type: AuthPasskeyChallengeResponseDto })
  @ApiResponse({ status: 400, description: 'No passkeys registered' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async generatePasskeyAuthChallenge(
    @Body() dto: AuthPasskeyChallengeDto,
  ): Promise<AuthPasskeyChallengeResponseDto> {
    return this.passkeyService.generateAuthChallenge(dto.email);
  }

  @Post('passkey/authenticate/verify')
  @ApiOperation({ summary: 'Verify passkey authentication and return JWT' })
  @ApiResponse({ status: 200, type: TokenResponseDto })
  @ApiResponse({ status: 400, description: 'Verification failed' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async verifyPasskeyAuthentication(
    @Body() dto: VerifyPasskeyAuthenticationDto,
  ): Promise<TokenResponseDto> {
    return this.passkeyService.verifyAuthentication(dto.email, dto.response);
  }

  // Passkey Management Endpoints (require JWT)
  @Get('passkey/list')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all passkeys for current user' })
  @ApiResponse({ status: 200, type: PasskeyListResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async listPasskeys(@Request() req): Promise<PasskeyListResponseDto> {
    return this.passkeyService.listPasskeys(req.user.userId);
  }

  @Delete('passkey/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a passkey' })
  @ApiResponse({ status: 200, description: 'Passkey deleted' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Passkey not found' })
  async deletePasskey(
    @Request() req,
    @Param('id') credentialId: string,
  ): Promise<{ success: boolean }> {
    await this.passkeyService.deletePasskey(req.user.userId, credentialId);
    return { success: true };
  }
}
