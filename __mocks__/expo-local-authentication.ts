export const hasHardwareAsync = jest.fn(async () => true);
export const isEnrolledAsync = jest.fn(async () => true);
export const authenticateAsync = jest.fn(async () => ({
  success: true,
}));
