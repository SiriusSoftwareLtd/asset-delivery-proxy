import type { Context } from 'hono';
import type { BlankInput } from 'hono/types';
import type { AppEnvironment } from '../types';

export async function handleIconRequest(c: Context<AppEnvironment, '/icons/:iconPack/:iconName', BlankInput>) {
  return c.json({ message: 'icon request' }, 200);
}
