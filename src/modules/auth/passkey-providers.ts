/**
 * Quién guarda cada passkey.
 *
 * Cada autenticador se identifica con una AAGUID que viene en el registro y
 * dice qué lo emitió: el llavero de iCloud, el gestor de Google, 1Password.
 * Sirve para reconocer una credencial de un vistazo — "iPhone" y "Chrome
 * Browser" son nombres que puso el usuario y no dicen dónde vive la llave.
 *
 * La lista es de identificadores públicos y estables. No pretende ser
 * exhaustiva: lo que no está devuelve null y la interfaz no muestra proveedor,
 * que es mejor que adivinar.
 */
export interface Proveedor {
  /** Slug estable, para que la interfaz elija el ícono. */
  id: string;
  /** Nombre legible, para el tooltip y los lectores de pantalla. */
  nombre: string;
}

const PROVEEDORES: Record<string, Proveedor> = {
  // Apple
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': { id: 'apple', nombre: 'Llavero de iCloud' },
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': { id: 'apple', nombre: 'Llavero de iCloud' },
  // Google
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': { id: 'google', nombre: 'Gestor de Google' },
  'adce0002-35bc-c60a-648b-0b25f1f05503': { id: 'google', nombre: 'Chrome' },
  // Microsoft
  '08987058-cadc-4b81-b6e1-30de50dcbe96': { id: 'microsoft', nombre: 'Windows Hello' },
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': { id: 'microsoft', nombre: 'Windows Hello' },
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': { id: 'microsoft', nombre: 'Windows Hello' },
  // Gestores de contraseñas
  'bada5566-a7aa-401f-bd96-45619a55120d': { id: '1password', nombre: '1Password' },
  'd548826e-79b4-db40-a3d8-11116f7e8349': { id: 'bitwarden', nombre: 'Bitwarden' },
  '531126d6-e717-415c-9320-3d9aa6981239': { id: 'dashlane', nombre: 'Dashlane' },
  'b84e4048-15dc-4dd0-8640-f4f60813c8af': { id: 'nordpass', nombre: 'NordPass' },
  '0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6': { id: 'keeper', nombre: 'Keeper' },
  'f3809540-7f14-49c1-a8b3-8f813b225541': { id: 'enpass', nombre: 'Enpass' },
  '891494da-2c90-4d31-a9cd-4eab0aed1309': { id: 'proton', nombre: 'Proton Pass' },
};

/** Una AAGUID en ceros significa "no lo dijo", no un proveedor desconocido. */
const SIN_DECLARAR = '00000000-0000-0000-0000-000000000000';

/**
 * El proveedor detrás de una AAGUID, o `null` cuando el autenticador no la
 * declaró o no está en la lista. Devolver null es deliberado: la interfaz
 * simplemente no muestra proveedor, en vez de inventar uno.
 */
export function proveedorDePasskey(aaguid?: string): Proveedor | null {
  if (!aaguid || aaguid === SIN_DECLARAR) return null;
  return PROVEEDORES[aaguid.toLowerCase()] ?? null;
}
