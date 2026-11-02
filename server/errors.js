export class AppError extends Error {
  constructor(message, status = 400, expose = true) {
    super(message);
    this.status = status;
    this.expose = expose;
  }
}
