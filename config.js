/* Ruta del día: configuración.
   Estos dos datos de Supabase son públicos por diseño (la seguridad la ponen las reglas de la base).
   La clave de OpenRouteService NO va aquí: va en Vercel, como variable ORS_API_KEY. */
var RUTA_CONFIG = {
  // Supabase > Project Settings > API
  SUPABASE_URL: 'https://uvotorqggfqaadijpvte.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_vG83Ssc6XlamIsuccS4N4A_mtHtKPTc',

  // Esquema de esta app dentro del proyecto de Supabase
  ESQUEMA: 'ruta',

  // WhatsApp de soporte, con código de país y sin signos. Ejemplo: '51987654321'. Vacío = no se muestra.
  WHATSAPP_SOPORTE: '',

  // Colores de marca. Para integrarla en Plop: TINTA '#260D3D' y ACENTO '#FFE600'.
  TINTA: '#10231C',
  ACENTO: '#D7F25A',

  ZONA_HORARIA: 'America/Lima'
};

if (typeof module !== 'undefined' && module.exports) module.exports = RUTA_CONFIG;
if (typeof window !== 'undefined') window.RUTA_CONFIG = RUTA_CONFIG;
