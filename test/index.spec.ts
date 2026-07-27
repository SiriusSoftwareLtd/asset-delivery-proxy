import { env } from 'cloudflare:test'
import { describe, expect, test } from 'vitest'
import worker from '../src'

describe('Test the application', () => {
	test('Should return 200 response', async () => {
		const res = await worker.request('/assets/123')
		expect(res.status).toBe(200)
	})
})
