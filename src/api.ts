import axios from 'axios';

const API_URL = (import.meta as any).env?.VITE_API_URL || '';

export const api = axios.create({
  baseURL: API_URL,
});

api.interceptors.response.use(
  (response) => {
    // Check if the application logic returned an error status in JSON
    if (response.data && response.data.status === 'error') {
       return Promise.reject(new Error(response.data.error || 'Unknown API Error'));
    }
    return response;
  },
  (error) => {
    let errorMessage = "An error occurred";
    if (error.response && error.response.data && error.response.data.error) {
      errorMessage = error.response.data.error;
    } else if (error.message) {
      errorMessage = error.message;
    }
    return Promise.reject(new Error(errorMessage));
  }
);
