import type { SQLiteDatabase } from 'expo-sqlite'
import { expect, test } from 'vitest'

import { ConnectionMutex, ExpoDriver } from '../src/driver.js'

for (const scenario of ['priority', 'fairness'] as const) {
  test(`connection priority preserves ownership, FIFO and ${scenario}`, async () => {
    const params = {
      database: {} as SQLiteDatabase,
      destroy: async () => {},
      mutex: new ConnectionMutex(),
    }
    const driver = new ExpoDriver(params)
    const lowDriver = new ExpoDriver({ ...params, priority: 'low' })
    await driver.acquireConnection()
    const order: Array<string> = []
    const acquire = (name: string, priority: 'high' | 'low') =>
      (priority === 'low' ? lowDriver : driver).acquireConnection().then(async () => {
        order.push(name)
        await driver.releaseConnection()
      })
    const low = [acquire('low0', 'low'), acquire('low1', 'low')]
    const highs = Array.from({ length: scenario === 'priority' ? 2 : 20 }, (_, i) =>
      acquire(`high${i}`, 'high'),
    )
    await Promise.resolve()
    expect(order).toEqual([])
    await driver.releaseConnection()
    await Promise.all([...low, ...highs])
    expect(order[0]).toBe('high0')
    expect(order.filter((name) => name.startsWith('high'))).toEqual(highs.map((_, i) => `high${i}`))
    expect(order.filter((name) => name.startsWith('low'))).toEqual(['low0', 'low1'])
    if (scenario === 'fairness') {
      expect(order.indexOf('low0')).toBe(7)
      expect(order.indexOf('low1')).toBe(16)
    }
  })
}

test('default priority stays FIFO and queued low requests progress without high requests', async () => {
  const params = {
    database: {} as SQLiteDatabase,
    destroy: async () => {},
    mutex: new ConnectionMutex(),
  }
  const driver = new ExpoDriver(params)
  const lowDriver = new ExpoDriver({ ...params, priority: 'low' })
  await driver.acquireConnection()
  const order: Array<string> = []
  const high = Array.from({ length: 3 }, (_, index) =>
    driver.acquireConnection().then(async () => {
      order.push(`high${index}`)
      await driver.releaseConnection()
    }),
  )
  const low = Array.from({ length: 3 }, (_, index) =>
    lowDriver.acquireConnection().then(async () => {
      order.push(`low${index}`)
      await driver.releaseConnection()
    }),
  )
  expect(order).toEqual([])
  await driver.releaseConnection()
  await Promise.all([...high, ...low])
  expect(order).toEqual(['high0', 'high1', 'high2', 'low0', 'low1', 'low2'])
})

test('a high request does not preempt the low connection holder', async () => {
  const params = {
    database: {} as SQLiteDatabase,
    destroy: async () => {},
    mutex: new ConnectionMutex(),
  }
  const high = new ExpoDriver(params)
  const low = new ExpoDriver({ ...params, priority: 'low' })
  await low.acquireConnection()
  let acquired = false
  const next = high.acquireConnection().then(() => {
    acquired = true
  })
  await Promise.resolve()
  expect(acquired).toBe(false)
  await low.releaseConnection()
  await next
  expect(acquired).toBe(true)
  await high.releaseConnection()
})
