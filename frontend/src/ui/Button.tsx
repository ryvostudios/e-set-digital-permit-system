import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  block?: boolean;
  /**
   * Shows a spinner AND disables the control. Duplicate submission
   * protection is therefore built into the button itself rather than
   * left to each form to remember.
   */
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  block = false,
  loading = false,
  disabled = false,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const classes = ['btn', `btn--${variant}`, size === 'sm' ? 'btn--sm' : '', block ? 'btn--block' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <button {...rest} type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined}>
      {loading ? <span className="btn__spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> {
  /** REQUIRED: an icon alone is never an accessible name. */
  label: string;
  icon: ReactNode;
  /** Rendered as a count bubble - used for the unread notification badge. */
  badge?: number;
  onDark?: boolean;
}

export function IconButton({ label, icon, badge, onDark = false, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={onDark ? 'icon-btn icon-btn--on-dark' : 'icon-btn'}
      aria-label={badge ? `${label} (${badge} unread)` : label}
      title={label}
    >
      <span aria-hidden="true">{icon}</span>
      {badge && badge > 0 ? (
        <span className="icon-btn__badge" aria-hidden="true">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </button>
  );
}
