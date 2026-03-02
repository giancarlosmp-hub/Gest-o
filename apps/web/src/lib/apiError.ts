export function getApiErrorMessage(error: unknown, fallbackMessage: string) {
  const maybeAxiosError = error as {
    response?: { status?: number; data?: { message?: string } };
    message?: string;
  };

  const status = maybeAxiosError.response?.status;
  const backendMessage = maybeAxiosError.response?.data?.message;
  const message = backendMessage || maybeAxiosError.message || fallbackMessage;

  return status ? `${status} - ${message}` : message;
}
