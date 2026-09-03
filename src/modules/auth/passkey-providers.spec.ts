import { proveedorDePasskey } from './passkey-providers';

describe('proveedorDePasskey · quién guarda la llave', () => {
  it('reconoce los proveedores conocidos', () => {
    expect(proveedorDePasskey('fbfc3007-154e-4ecc-8c0b-6e020557d7bd')).toEqual({
      id: 'apple',
      nombre: 'Llavero de iCloud',
    });
    expect(proveedorDePasskey('ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4')).toEqual({
      id: 'google',
      nombre: 'Gestor de Google',
    });
    expect(proveedorDePasskey('bada5566-a7aa-401f-bd96-45619a55120d')).toEqual({
      id: '1password',
      nombre: '1Password',
    });
  });

  it('no se pierde por mayúsculas', () => {
    expect(proveedorDePasskey('FBFC3007-154E-4ECC-8C0B-6E020557D7BD')?.id).toBe(
      'apple',
    );
  });

  it('una AAGUID en ceros es "no lo dijo", no un proveedor', () => {
    // Algunos autenticadores la anulan por privacidad. Inventar un nombre ahí
    // sería peor que no mostrar nada.
    expect(proveedorDePasskey('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('lo que no está en la lista no se adivina', () => {
    expect(proveedorDePasskey('11111111-2222-3333-4444-555555555555')).toBeNull();
  });

  it('una credencial vieja, sin el dato guardado, no rompe', () => {
    // Los passkeys registrados antes de guardar la AAGUID no la tienen y no
    // se puede deducir después.
    expect(proveedorDePasskey(undefined)).toBeNull();
    expect(proveedorDePasskey('')).toBeNull();
  });
});
