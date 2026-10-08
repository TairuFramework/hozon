export class InvalidBlobIDError extends Error {
  constructor(id: string, options?: ErrorOptions) {
    super(`Invalid blob ID: ${JSON.stringify(id)}`, options)
    this.name = 'InvalidBlobIDError'
  }
}
