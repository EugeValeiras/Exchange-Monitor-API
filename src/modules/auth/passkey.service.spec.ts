import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PasskeyService } from './passkey.service';
import { UsersService } from '../users/users.service';

/**
 * El registro fallaba en TestFlight con "Domain not associated" porque
 * producción seguía con los valores de desarrollo (rpId 'localhost'). Al
 * corregirlo apareció el segundo problema: hay DOS clientes —la app iOS y la
 * webapp— y cada uno manda su propio origin, pero expectedOrigin era un único
 * string, así que arreglar uno rompía el otro.
 */
describe('PasskeyService · origins autorizados', () => {
  const build = async (passkeyOrigin?: string): Promise<PasskeyService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasskeyService,
        { provide: UsersService, useValue: {} },
        { provide: JwtService, useValue: {} },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'PASSKEY_ORIGIN' ? passkeyOrigin : undefined,
          },
        },
      ],
    }).compile();

    return module.get<PasskeyService>(PasskeyService);
  };

  it('acepta los origins de la app y de la webapp a la vez', async () => {
    const service = await build(
      'https://eugeniovaleiras.com,https://monitor.eugeniovaleiras.com',
    );

    expect(service['origins']).toEqual([
      'https://eugeniovaleiras.com',
      'https://monitor.eugeniovaleiras.com',
    ]);
  });

  it('tolera espacios alrededor de las comas', async () => {
    const service = await build(
      ' https://eugeniovaleiras.com , https://monitor.eugeniovaleiras.com ',
    );

    expect(service['origins']).toEqual([
      'https://eugeniovaleiras.com',
      'https://monitor.eugeniovaleiras.com',
    ]);
  });

  it('sigue soportando un único origin', async () => {
    const service = await build('https://eugeniovaleiras.com');

    expect(service['origins']).toEqual(['https://eugeniovaleiras.com']);
  });

  it('no deja entradas vacías por una coma de más', async () => {
    const service = await build('https://eugeniovaleiras.com,');

    expect(service['origins']).toEqual(['https://eugeniovaleiras.com']);
  });

  it('cae en localhost cuando no hay configuración', async () => {
    const service = await build(undefined);

    expect(service['origins']).toEqual(['http://localhost:3000']);
  });
});
