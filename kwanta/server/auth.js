import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

export const hashPassword = (pw) => bcrypt.hash(pw, 12);
export const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash);

export const signToken = (user) =>
  jwt.sign(
    { sub: user.id, email: user.email },
    config.jwtSecret,
    { expiresIn: '7d' }
  );

export const verifyToken = (token) => jwt.verify(token, config.jwtSecret);

export const isAdmin = (email) =>
  config.adminEmails.includes(String(email).toLowerCase());
