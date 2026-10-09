import type { ReactNode, SVGProps } from "react";

export const iconNames = ["home", "cases", "plus", "mail", "logout", "login", "menu", "close", "evidence", "review", "consent"] as const;
export type IconName = (typeof iconNames)[number];

const paths: Record<IconName, ReactNode> = {
  home: <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z" />,
  cases: <><path d="M3 7.5h7l2 2H21v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M3 7.5V6a1 1 0 0 1 1-1h5l2 2" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  logout: <><path d="M9 7V5a1 1 0 0 1 1-1h8v16h-8a1 1 0 0 1-1-1v-2" /><path d="M13 12H4" /><path d="m7 9-3 3 3 3" /></>,
  login: <><path d="M15 7V5a1 1 0 0 0-1-1H6v16h8a1 1 0 0 0 1-1v-2" /><path d="M11 12h9" /><path d="m17 9 3 3-3 3" /></>,
  menu: <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>,
  close: <><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>,
  evidence: <><path d="M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" /><path d="M14 3.5V8h4" /><path d="M9 13h6" /><path d="M9 17h4" /></>,
  review: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 2" /></>,
  consent: <><path d="M12 3 5 6v5c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6z" /><path d="m9 12 2 2 4-4" /></>,
};

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      {paths[name]}
    </svg>
  );
}

export function Mark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" {...props}>
      <rect x="3" y="12" width="4.5" height="9" rx="1" fill="currentColor" />
      <rect x="9.75" y="7" width="4.5" height="14" rx="1" fill="currentColor" />
      <rect x="16.5" y="3" width="4.5" height="18" rx="1" fill="currentColor" />
    </svg>
  );
}
