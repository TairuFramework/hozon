export class InvalidCursorError extends Error {
  constructor(options?: ErrorOptions) {
    super('Invalid cursor', options)
    this.name = 'InvalidCursorError'
  }
}
