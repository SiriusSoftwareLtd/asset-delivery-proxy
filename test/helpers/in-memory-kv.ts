/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type InMemoryKvValue = {
  value: ArrayBuffer;
  metadata?: unknown;
};

export type InMemoryKv = {
  values: Map<string, InMemoryKvValue>;
  getWithMetadata<T>(key: string): Promise<{ value: ArrayBuffer | null; metadata: T | null }>;
  get(key: string, type?: 'arrayBuffer'): Promise<ArrayBuffer | string | null>;
  put(key: string, value: ArrayBuffer, options?: { metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
};

export function createInMemoryKv(): InMemoryKv {
  const values = new Map<string, InMemoryKvValue>();

  return {
    values,

    async getWithMetadata<T>(key: string) {
      const stored = values.get(key);

      return {
        value: stored?.value ?? null,
        metadata: (stored?.metadata as T | undefined) ?? null,
      };
    },

    async get(key: string, type?: 'arrayBuffer') {
      const stored = values.get(key);

      if (!stored) {
        return null;
      }

      return type === 'arrayBuffer' ? stored.value : new TextDecoder().decode(stored.value);
    },

    async put(key: string, value: ArrayBuffer, options?: { metadata?: unknown }) {
      values.set(key, { value, metadata: options?.metadata });
    },

    async delete(key: string) {
      values.delete(key);
    },
  };
}
