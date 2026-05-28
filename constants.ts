export const MAP_DEFAULT_CENTER: [number, number] = [40.7484, -73.9856]; // Empire State Building
export const MAP_DEFAULT_ZOOM = 15;

export const MAP_STYLES: Record<string, { label: string; url: string; attribution: string }> = {
  dark: {
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
  },
  light: {
    label: 'Light',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
  },
  voyager: {
    label: 'Voyager',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri',
  },
  streets: {
    label: 'Streets',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap',
  },
};

export const FONT_STYLES: Record<string, { label: string; fontFamily: string }> = {
  sans:  { label: 'Sans-serif',  fontFamily: "system-ui, -apple-system, sans-serif" },
  serif: { label: 'Serif',       fontFamily: "Georgia, 'Times New Roman', serif" },
  mono:  { label: 'Monospace',   fontFamily: "'Courier New', Courier, monospace" },
};

export const VOICES: { name: string; description: string; gender: string; sampleUrl?: string }[] = [
  // Female
  { name: 'Kore',         description: 'Firm, clear',            gender: 'F', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/kore.wav' },
  { name: 'Aoede',        description: 'Smooth, breezy',         gender: 'F', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/aoede.wav' },
  { name: 'Leda',         description: 'Warm, friendly',         gender: 'F', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/leda.wav' },
  { name: 'Zephyr',       description: 'Bright, upbeat',         gender: 'F', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/zephyr.wav' },
  { name: 'Callirrhoe',   description: 'Soft, measured',         gender: 'F', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/callirrhoe.wav' },
  { name: 'Autonoe',      description: 'Crisp, direct',          gender: 'F', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/autonoe.wav' },
  { name: 'Despina',      description: 'Gentle, thoughtful',     gender: 'F', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/despina.wav' },
  { name: 'Erinome',      description: 'Airy, melodic',          gender: 'F', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/erinome.wav' },
  { name: 'Laomedeia',    description: 'Lively, expressive',     gender: 'F', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/laomedeia.wav' },
  { name: 'Pulcherrima',  description: 'Elegant, resonant',      gender: 'F', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/pulcherrima.wav' },
  { name: 'Vindemiatrix', description: 'Warm, grounded',         gender: 'F', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/vindemiatrix.wav' },
  // Male
  { name: 'Fenrir',       description: 'Intense, excitable',     gender: 'M', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/fenrir.wav' },
  { name: 'Puck',         description: 'Playful, youthful',      gender: 'M', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/puck.wav' },
  { name: 'Charon',       description: 'Deep, authoritative',    gender: 'M', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/charon.wav' },
  { name: 'Orus',         description: 'Confident, steady',      gender: 'M', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/orus.wav' },
  { name: 'Enceladus',    description: 'Smooth, professional',   gender: 'M', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/enceladus.wav' },
  { name: 'Gacrux',       description: 'Relaxed, conversational',gender: 'M', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/gacrux.wav' },
  { name: 'Rasalgethi',   description: 'Warm, welcoming',        gender: 'M', sampleUrl: 'https://pzlgiurtjrmkpbjlaabz.supabase.co/storage/v1/object/public/audio/voice-samples/rasalgethi.wav' },
  { name: 'Sadachbia',    description: 'Energetic, punchy',      gender: 'M' },
  { name: 'Sadaltager',   description: 'Steady, trustworthy',    gender: 'M' },
  { name: 'Schedar',      description: 'Deep, thoughtful',       gender: 'M' },
  { name: 'Umbriel',      description: 'Quiet, intense',         gender: 'M' },
];

export const CHARACTER_TEMPLATES: { label: string; icon: string; prompt: string }[] = [
  {
    label: 'Storyteller',
    icon: '📖',
    prompt: "You are a captivating storyteller narrating the history of this exact location. Speak in the present tense as if events are unfolding around the listener right now. Keep each response to 2-3 sentences. Be vivid and atmospheric.",
  },
  {
    label: 'Park Ranger',
    icon: '🌲',
    prompt: "You are a knowledgeable and friendly park ranger. You know everything about the local wildlife, plants, and history of this area. You're enthusiastic about nature and happy to answer questions. Keep responses concise and informative.",
  },
  {
    label: 'Puzzle Guardian',
    icon: '🔐',
    prompt: "You are a mysterious guardian who protects a secret. You speak in riddles and will only reveal the secret passphrase when the player has demonstrated they are worthy — by answering your riddle correctly or showing genuine curiosity. Be cryptic but fair.",
  },
  {
    label: 'Ghost',
    icon: '👻',
    prompt: "You are the ghost of someone who lived here long ago. You are confused about the passage of time and speak about your era as if it were recent. You are melancholy but not frightening. You long for someone to hear your story.",
  },
];

// Sample audio files for testing since we don't have a real backend storage in this demo
export const SAMPLE_AUDIO_FILES = [
  { label: 'Nature Ambiance', url: 'https://actions.google.com/sounds/v1/ambiences/forest_morning.ogg' },
  { label: 'City Traffic', url: 'https://actions.google.com/sounds/v1/ambiences/city_traffic.ogg' },
  { label: 'Jazz Music', url: 'https://actions.google.com/sounds/v1/ambiences/coffee_shop.ogg' },
  { label: 'Rain', url: 'https://actions.google.com/sounds/v1/weather/rain_heavy_loud.ogg' },
  { label: 'Thunder', url: 'https://actions.google.com/sounds/v1/weather/thunder_crack.ogg' },
];