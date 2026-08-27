import { useContext } from 'react';
import { AuthContext, type AuthState } from './AuthProvider';
import type { Capabilities } from './capabilities';
import type { CurrentUser } from '../api/types';

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/**
 * The current user and capabilities, for screens that only ever render
 * inside the authenticated shell. Throwing here is correct: reaching one
 * of those screens without an identity would be a routing bug, and
 * silently rendering an empty page would hide it.
 */
export function useCurrentUser(): { user: CurrentUser; capabilities: Capabilities } {
  const { user, capabilities } = useAuth();
  if (!user || !capabilities) throw new Error('No authenticated user in this part of the application');
  return { user, capabilities };
}
