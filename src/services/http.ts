import axios from 'axios';

export const http = axios.create({
  timeout: 12_000,
  headers: { 'Accept': 'application/json' },
});