/**
 * Every route path in the application, in one place. Screens navigate by
 * calling these, so no path is ever spelled out twice.
 */
export const ROUTES = {
  login: '/login',
  changePassword: '/change-password',
  home: '/',
  apply: '/permits/apply',
  permit: (id: string) => `/permits/${id}`,
  permitPattern: '/permits/:id',
  records: '/records',
  croQueue: '/review/cro',
  hseQueue: '/review/hse',
  notifications: '/notifications',
  employees: '/admin/employees',
  employeeNew: '/admin/employees/new',
  employee: (id: string) => `/admin/employees/${id}`,
  employeePattern: '/admin/employees/:id',
  siteManagers: '/admin/site-managers',
} as const;
