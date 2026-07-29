/**
 * Third-party notices.
 *
 * Some dependencies require attribution as a condition of use — most software
 * licences (MIT, Apache) ask for it, and map tile providers and the 8th Wall
 * AR engine require it explicitly. A single page is the conventional home for
 * these: it keeps the requirement satisfied without accreting notices into the
 * interface, and gives every future dependency somewhere to go.
 *
 * Add an entry whenever a dependency's licence asks for attribution.
 */

import type { TermsSection } from './terms';

export const LICENSES_VERSION = '2026-07-28';

export const LICENSES_SECTIONS: TermsSection[] = [
  {
    heading: 'Maps and imagery',
    body: [
      'Map rendering by MapLibre GL JS, © MapLibre contributors, BSD-3-Clause.',
      'Vector map styles © CARTO, with map data © OpenStreetMap contributors, available under the Open Database License.',
      'Satellite imagery © Esri, and its imagery partners, including Maxar, Earthstar Geographics, and the GIS User Community.',
      'Place search by Nominatim, © OpenStreetMap contributors.',
    ],
  },
  {
    heading: 'Augmented reality',
    body: [
      'AR world tracking by the 8th Wall Engine, © Niantic Spatial, Inc. Used under its distributed engine binary licence.',
      'The engine is provided by Niantic Spatial as-is and without warranty of any kind, express or implied, including any warranty of merchantability or fitness for a particular purpose. Niantic Spatial is not liable for any claim or damages arising from its use.',
      '3D rendering by three.js, © three.js authors, MIT licence. Compressed model decoding by Draco, © Google, Apache 2.0.',
    ],
  },
  {
    heading: 'Artificial intelligence',
    body: [
      'Character conversation, experience generation, and content review use Google Gemini. Voice generation, where a creator enables it, uses ElevenLabs.',
      'AI output is generated and may be inaccurate. It does not represent the views of Obelisk.',
    ],
  },
  {
    heading: 'Application',
    body: [
      'Built with React, © Meta Platforms, and React Router, both MIT licensed.',
      'Icons by Lucide, ISC licence, derived from Feather Icons, © Cole Bemis, MIT.',
      'Backend services by Supabase, Apache 2.0. Hosting by Vercel.',
      'Geospatial calculations by Turf.js, MIT licence.',
    ],
  },
];
