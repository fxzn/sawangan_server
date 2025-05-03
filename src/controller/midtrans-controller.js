import { prismaClient } from '../application/database.js';
import midtransClient from 'midtrans-client';

export const handleMidtransNotification = async (req, res) => {
  try {
    const notification = req.body;
    
    // Validasi notifikasi
    const snap = new midtransClient.Snap({
      isProduction: process.env.NODE_ENV === 'production',
      serverKey: process.env.MIDTRANS_SERVER_KEY
    });

    const statusResponse = await snap.transaction.notification(notification);
    const orderId = statusResponse.order_id;
    const transactionStatus = statusResponse.transaction_status;
    const fraudStatus = statusResponse.fraud_status;

    console.log(`Received transaction status: ${transactionStatus} for order ID: ${orderId}`);

    // Cari order di database
    const order = await prismaClient.order.findUnique({
      where: { id: orderId }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Update status berdasarkan notifikasi
    let updatedStatus = order.status;
    let paymentStatus = order.paymentStatus;

    if (transactionStatus === 'capture') {
      if (fraudStatus === 'challenge') {
        updatedStatus = 'PENDING';
        paymentStatus = 'CHALLENGE';
      } else if (fraudStatus === 'accept') {
        updatedStatus = 'PAID';
        paymentStatus = 'PAID';
      }
    } else if (transactionStatus === 'settlement') {
      updatedStatus = 'PAID';
      paymentStatus = 'PAID';
    } else if (transactionStatus === 'cancel' || 
               transactionStatus === 'deny' ||
               transactionStatus === 'expire') {
      updatedStatus = 'CANCELLED';
      paymentStatus = 'FAILED';
    } else if (transactionStatus === 'pending') {
      updatedStatus = 'PENDING';
      paymentStatus = 'PENDING';
    }

    // Update order di database
    await prismaClient.order.update({
      where: { id: orderId },
      data: {
        status: updatedStatus,
        paymentStatus,
        paymentMethod: statusResponse.payment_type || order.paymentMethod,
        paidAt: paymentStatus === 'PAID' ? new Date() : null
      }
    });

    // Buat payment log
    await prismaClient.paymentLog.create({
      data: {
        orderId,
        paymentMethod: statusResponse.payment_type,
        amount: parseFloat(statusResponse.gross_amount),
        status: paymentStatus,
        transactionId: statusResponse.transaction_id,
        payload: JSON.stringify(statusResponse)
      }
    });

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error handling notification:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};