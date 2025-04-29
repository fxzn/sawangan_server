import { Router } from 'express';
import { forgotPassword, googleAuth, login, register, resetPassword } from '../controller/user-controller.js';
import { getAllProducts } from '../controller/product-controller.js';



const publicRouter = Router();

publicRouter.post('/api/v1/auth/register', register);
publicRouter.post('/api/v1/auth/login', login);
publicRouter.post('/api/v1/auth/forgot-password', forgotPassword);
publicRouter.post('/api/v1/auth/reset-password', resetPassword);
publicRouter.post('/api/v1/auth/google', googleAuth);

publicRouter.get('/api/v1/products', getAllProducts);

export default publicRouter
