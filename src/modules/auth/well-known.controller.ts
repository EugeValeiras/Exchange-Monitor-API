import { Controller, Get, Header } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('well-known')
@Controller('.well-known')
export class WellKnownController {
  constructor(private readonly configService: ConfigService) {}

  // Apple App Site Association for iOS Passkeys
  @Get('apple-app-site-association')
  @Header('Content-Type', 'application/json')
  @ApiOperation({ summary: 'Apple App Site Association for iOS Passkeys' })
  @ApiResponse({ status: 200, description: 'AASA file for iOS credential sharing' })
  getAppleAppSiteAssociation() {
    return {
      webcredentials: {
        apps: ['XR693653J9.com.eugeniovaleiras.exchangeMonitor'],
      },
    };
  }

  // Digital Asset Links for Android Passkeys
  @Get('assetlinks.json')
  @Header('Content-Type', 'application/json')
  @ApiOperation({ summary: 'Digital Asset Links for Android Passkeys' })
  @ApiResponse({ status: 200, description: 'Asset links for Android credential sharing' })
  getAssetLinks() {
    // Get SHA256 fingerprints from env (comma-separated if multiple)
    const fingerprintsEnv = this.configService.get<string>('ANDROID_SHA256_FINGERPRINTS') || '';
    const fingerprints = fingerprintsEnv
      .split(',')
      .map((fp) => fp.trim())
      .filter((fp) => fp.length > 0);

    return [
      {
        relation: ['delegate_permission/common.get_login_creds'],
        target: {
          namespace: 'android_app',
          package_name: 'com.eugeniovaleiras.exchange_monitor',
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ];
  }
}
