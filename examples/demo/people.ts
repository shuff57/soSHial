// The demo's seeded class. Every name is made up.

export const CLASS_ID = 'period-3';
export const CLASS_NAME = 'Period 3';

export interface DemoPerson {
  id: string;
  first: string;
  last: string | null;
  role: 'teacher' | 'student';
  /** What the "You are" picker shows. */
  label: string;
}

// The teacher's whole name is in first_name, so the example directory shows "Ms Rivera"
// rather than first name + last initial.
export const PEOPLE: DemoPerson[] = [
  { id: 'u-sam', first: 'Sam', last: 'Okafor', role: 'student', label: 'Sam (student)' },
  { id: 'u-alex', first: 'Alex', last: 'Brandt', role: 'student', label: 'Alex (student)' },
  { id: 'u-jordan', first: 'Jordan', last: 'Pike', role: 'student', label: 'Jordan (student)' },
  { id: 'u-rivera', first: 'Ms Rivera', last: null, role: 'teacher', label: 'Ms Rivera (teacher)' },
];

/** What the server hands the page in window.__DEMO__. */
export interface DemoBoot {
  me: string | null;
  classId: string;
  className: string;
  people: { id: string; label: string; role: 'teacher' | 'student' }[];
}
