import express from 'express';
import {humanClick, humanScroll, humanType} from '../../humanize/service';

const router = express.Router();

router.post('/click', async (req, res) => {
  try {
    if (!req.body?.windowId) {
      res.status(400).send({success: false, message: 'windowId is required'});
      return;
    }
    const result = await humanClick(req.body);
    res.send(result);
  } catch (error) {
    res.status(500).send({success: false, message: (error as Error).message});
  }
});

router.post('/type', async (req, res) => {
  try {
    if (!req.body?.windowId || typeof req.body?.text !== 'string') {
      res.status(400).send({success: false, message: 'windowId and text are required'});
      return;
    }
    const result = await humanType(req.body);
    res.send(result);
  } catch (error) {
    res.status(500).send({success: false, message: (error as Error).message});
  }
});

router.post('/scroll', async (req, res) => {
  try {
    if (!req.body?.windowId) {
      res.status(400).send({success: false, message: 'windowId is required'});
      return;
    }
    const result = await humanScroll(req.body);
    res.send(result);
  } catch (error) {
    res.status(500).send({success: false, message: (error as Error).message});
  }
});

export default router;
