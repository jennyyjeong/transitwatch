import { Router } from 'express';
const router = Router();

router.get('/', (req, res) => {
    res.render('tracking', { title: 'Live Tracking' });
});

router.get('/route-finder', (req, res) => {
    res.render('routeFinder', { title: 'Route Finder' });
});

export default router;
