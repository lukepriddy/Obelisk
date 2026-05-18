import { User, Tour, Zone } from '../types';

const simpleUuid = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

// Initial Data
const DEMO_USER_ID = 'user_123';
const DEMO_TOUR_ID = 'tour_demo';

const INITIAL_TOURS: Tour[] = [
  {
    id: DEMO_TOUR_ID,
    owner_id: DEMO_USER_ID,
    title: 'Central Park Walk',
    description: 'A relaxing sound walk through the park. Put on your headphones.',
    is_public: true,
    created_at: new Date().toISOString(),
    lat: 40.785091,
    lng: -73.968285
  }
];

const DEFAULT_ZONE_PROPS = {
  type: 'audio' as const,
  volume: 1.0,
  is_visible: true,
  show_progress: false,
  use_attenuation: true,
  fade_in: 0.5,
  fade_out: 2.0,
  on_exit: 'stop' as const,
  on_end: 'loop' as const,
  character_prompt: 'You are a helpful guide.',
  voice_style: 'Kore',
  entry_message: '',
  greeting_message: '',
  avatar_unlock_zone_id: '',
  lock_type: 'none' as const,
  lock_passphrase: '',
  lock_hint: '',
  requires_zone_id: '',
};

const INITIAL_ZONES: Zone[] = [
  {
    id: 'zone_1',
    tour_id: DEMO_TOUR_ID,
    lat: 40.785091,
    lng: -73.968285,
    radius: 100,
    media_url: 'https://actions.google.com/sounds/v1/ambiences/forest_morning.ogg',
    title: 'Great Lawn',
    description: 'Hear the morning birds.',
    ...DEFAULT_ZONE_PROPS
  },
  {
    id: 'zone_2',
    tour_id: DEMO_TOUR_ID,
    lat: 40.7820,
    lng: -73.9650,
    radius: 80,
    media_url: 'https://actions.google.com/sounds/v1/weather/rain_heavy_loud.ogg',
    title: 'Turtle Pond',
    description: 'Sudden rainstorm sounds.',
    ...DEFAULT_ZONE_PROPS
  },
  {
    id: 'zone_3',
    tour_id: DEMO_TOUR_ID,
    lat: 40.7840,
    lng: -73.9660,
    radius: 60,
    media_url: '',
    title: 'The Park Ranger',
    description: 'Ask the ranger about the history of the park.',
    ...DEFAULT_ZONE_PROPS,
    type: 'character',
    character_prompt: 'You are an old, grumpy but knowledgeable Park Ranger named Ranger Rick. You know everything about Central Park history. You speak with a slight New York accent and use slang like "pal" or "buddy".',
    voice_style: 'Fenrir'
  }
];

// LocalStorage Keys
const KEYS = {
  SESSION: 'soundmaps_session',
  TOURS: 'soundmaps_tours',
  ZONES: 'soundmaps_zones'
};

class MockSupabaseService {
  constructor() {
    this.init();
  }

  // In-memory fallback
  private memoryStorage: Record<string, string> = {};

  private getItem(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return this.memoryStorage[key] || null;
    }
  }

  private setItem(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      this.memoryStorage[key] = value;
    }
  }

  private removeItem(key: string) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      delete this.memoryStorage[key];
    }
  }

  private init() {
    if (!this.getItem(KEYS.TOURS)) {
      this.setItem(KEYS.TOURS, JSON.stringify(INITIAL_TOURS));
    }
    if (!this.getItem(KEYS.ZONES)) {
      this.setItem(KEYS.ZONES, JSON.stringify(INITIAL_ZONES));
    }
  }

  // Auth
  auth = {
    signInWithEmail: async (email: string) => {
      // Fake auth
      const user: User = { id: DEMO_USER_ID, email };
      this.setItem(KEYS.SESSION, JSON.stringify(user));
      return { user, error: null };
    },
    signOut: async () => {
      this.removeItem(KEYS.SESSION);
    },
    getSession: (): User | null => {
      const session = this.getItem(KEYS.SESSION);
      return session ? JSON.parse(session) : null;
    }
  };

  // DB
  from(table: 'tours' | 'zones') {
    return {
      select: async (query?: string): Promise<{ data: any[], error: any }> => {
        await new Promise(r => setTimeout(r, 100)); // Network delay
        const key = table === 'tours' ? KEYS.TOURS : KEYS.ZONES;
        let data = JSON.parse(this.getItem(key) || '[]');
        return { data, error: null };
      },
      insert: async (item: any) => {
        const key = table === 'tours' ? KEYS.TOURS : KEYS.ZONES;
        const items = JSON.parse(this.getItem(key) || '[]');
        // Merge defaults if it's a zone
        const newItem = table === 'zones' 
          ? { ...DEFAULT_ZONE_PROPS, ...item[0], id: simpleUuid() } 
          : { ...item[0], id: simpleUuid() };
          
        items.push(newItem);
        this.setItem(key, JSON.stringify(items));
        return { data: [newItem], error: null };
      },
      update: (updates: any) => {
        return {
           eq: async (column: string, value: string) => {
              const key = table === 'tours' ? KEYS.TOURS : KEYS.ZONES;
              const items = JSON.parse(this.getItem(key) || '[]');
              const index = items.findIndex((i: any) => i[column] === value);
              if (index !== -1) {
                items[index] = { ...items[index], ...updates };
                this.setItem(key, JSON.stringify(items));
                return { data: [items[index]], error: null };
              }
              return { data: [], error: 'Not found' };
           }
        }
      },
      delete: () => {
        return {
          eq: async (column: string, value: string) => {
             const key = table === 'tours' ? KEYS.TOURS : KEYS.ZONES;
             let items = JSON.parse(this.getItem(key) || '[]');
             items = items.filter((i: any) => i[column] !== value);
             this.setItem(key, JSON.stringify(items));
             return { error: null };
          }
        }
      }
    };
  }

  // Helpers
  async getToursByUser(userId: string) {
    const { data } = await this.from('tours').select();
    return data.filter((t: Tour) => t.owner_id === userId);
  }

  async getZonesByTourId(tourId: string) {
    const { data } = await this.from('zones').select();
    return data.filter((z: Zone) => z.tour_id === tourId);
  }

  async getTourById(tourId: string) {
     const { data } = await this.from('tours').select();
     return data.find((t: Tour) => t.id === tourId);
  }
}

export const mockSupabase = new MockSupabaseService();