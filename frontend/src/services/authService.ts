import { apiRequest } from './api';
import type { AuthResponse, LoginRequest } from '../types/auth';

export function login(payload: LoginRequest) {
  return apiRequest<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function logout() {
  return apiRequest<void>('/auth/logout', {
    method: 'POST',
  });
}

export function getCurrentUser() {
  return apiRequest<AuthResponse>('/auth/me');
}
