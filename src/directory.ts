// The one thing soSHial needs from your app: who is in a class, who teaches it, and what to call them.
// soSHial never reads your tables itself. Implement this once (see examples/sql-directory.ts for one
// over plain `classes` / `enrollments` / `users` tables) and pass it to createSoshial().

export type Role = 'teacher' | 'student';

export interface ClassInfo {
  id: string;
  name: string;
  /** An archived class keeps its conversations readable but nobody can send in it. */
  archived: boolean;
}

export interface Person {
  /** Your user id. Stored in soSHial's tables, never sent to a page. */
  id: string;
  /** The name shown to others, e.g. "Sam R." (first name + last initial keeps it short and private). */
  name: string;
  role: Role;
}

export interface ClassDirectory {
  /** The class, or null when there is no such class. */
  classInfo(classId: string): Promise<ClassInfo | null>;
  /** The user's role in the class NOW (a student whose enrollment ended is null), or null. */
  roleIn(classId: string, userId: string): Promise<Role | null>;
  /** Everyone in the class now: its teachers and its enrolled students. */
  people(classId: string): Promise<Person[]>;
  /** The live classes the user is in now, as a teacher or a student. */
  classesOf(userId: string): Promise<string[]>;
  /** The name shown for one user. */
  nameOf(userId: string): Promise<string>;
}

/** Who is asking. `admin` may use any class's teacher panel. */
export interface Session {
  userId: string;
  admin?: boolean;
}
