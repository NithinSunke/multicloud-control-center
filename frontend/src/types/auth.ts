export type User = {
  username: string;
  roles: string[];
};

export type LoginRequest = {
  username: string;
  password: string;
};

export type AuthResponse = {
  user: User;
};
