import { lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const singletonNames = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

export async function recoverProfile(profileDirectory, fs = { lstat, unlink }) {
  const links = [];
  // The Host has reserved this volume. Validate every candidate before removing any link.
  for (const name of singletonNames) {
    const path = join(profileDirectory, name);
    let entry;
    try {
      entry = await fs.lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!entry.isSymbolicLink()) throw new Error('Unexpected Chromium singleton entry');
    links.push(path);
  }

  for (const path of links) {
    try {
      await fs.unlink(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
