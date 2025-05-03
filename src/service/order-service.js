import axios from 'axios';
import { prismaClient } from '../application/database.js';
import { ResponseError } from '../error/response-error.js';

const getOrderList = async (userId, { page = 1, limit = 10 }) => {
  const skip = (page - 1) * limit;

  try {
    const [orders, totalOrders] = await Promise.all([
      prismaClient.order.findMany({
        where: { userId },
        select: {
          id: true,
          createdAt: true,
          status: true,
          trackingNumber: true,
          shipping_name: true,
          paymentStatus: true,
          totalAmount: true,
          items: {
            select: {
              quantity: true,
              price: true,
              productName: true,
              product: {
                select: {
                  name: true,
                  imageUrl: true
                }
              }
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prismaClient.order.count({ where: { userId } })
    ]);

    if (orders.length === 0) {
      throw new ResponseError(404, 'No orders found for this user');
    }

    return {
      data: orders.map(order => ({
        ...order,
        items: order.items.map(item => ({
          name: item.productName || item.product.name,
          quantity: item.quantity,
          price: item.price,
          image: item.product.imageUrl,
          total: item.price * item.quantity
        }))
      })),
      meta: {
        currentPage: page,
        totalPages: Math.ceil(totalOrders / limit),
        totalItems: totalOrders
      }
    };
  } catch (error) {
    console.error('Failed to fetch orders:', error);
    throw error;
  }
};

const getOrderDetail = async (userId, orderId) => {
  try {
    const order = await prismaClient.order.findUnique({
      where: { 
        id: orderId,
        userId 
      },
      select: {
        id: true,
        createdAt: true,
        status: true,
        trackingNumber: true,
        shipping_name: true,
        paymentStatus: true,
        totalAmount: true,
        shippingAddress: true,
        shippingCity: true,
        shippingProvince: true,
        shippingPostCode: true,
        customerName: true,
        customerPhone: true,
        shippingCost: true,
        estimatedDelivery: true,
        paymentMethod: true,
        paymentUrl: true,
        shippedAt: true,
        completedAt: true,
        items: {
          select: {
            quantity: true,
            price: true,
            productName: true,
            product: {
              select: {
                name: true,
                imageUrl: true
              }
            }
          }
        }
      }
    });

    if (!order) {
      throw new ResponseError(404, 'Order not found or access denied');
    }

    // Get tracking info if order is shipped and has tracking number
    let trackingInfo = null;
    let trackingError = null;
    
    if (order.status === 'SHIPPED' && order.trackingNumber && order.shipping_name) {
      try {
        trackingInfo = await trackShipping(
          order.shipping_name.toLowerCase(),
          order.trackingNumber
        );
      } catch (error) {
        trackingError = error.message;
      }
    }

    return {
      ...order,
      trackingInfo,
      trackingError,
      shippingDetails: {
        recipientName: order.customerName,
        phoneNumber: order.customerPhone,
        address: order.shippingAddress,
        city: order.shippingCity,
        province: order.shippingProvince,
        postalCode: order.shippingPostCode
      },
      items: order.items.map(item => ({
        name: item.productName || item.product.name,
        quantity: item.quantity,
        price: item.price,
        image: item.product.imageUrl,
        total: item.price * item.quantity
      })),
      orderSummary: {
        subtotal: order.totalAmount - order.shippingCost,
        shippingCost: order.shippingCost,
        totalAmount: order.totalAmount
      },
      timestamps: {
        shippedAt: order.shippedAt,
        completedAt: order.completedAt
      }
    };
  } catch (error) {
    console.error('Failed to fetch order details:', error);
    throw error;
  }
};

const updateOrderAdmin = async (orderId, { status, trackingNumber, shipping_name

 }) => {
  return await prismaClient.$transaction(async (prisma) => {
    const existingOrder = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: {
          select: {
            fullName: true,
            email: true,
            phone: true
          }
        }
      }
    });

    if (!existingOrder) {
      throw new ResponseError(404, 'Order not found');
    }

    const validTransitions = {
      PENDING: ['PACKAGED', 'CANCELLED'],
      PACKAGED: ['SHIPPED', 'CANCELLED'],
      SHIPPED: ['COMPLETED'],
      COMPLETED: [],
      CANCELLED: []
    };

    if (!validTransitions[existingOrder.status]?.includes(status)) {
      throw new ResponseError(
        400, 
        `Invalid status transition from ${existingOrder.status} to ${status}`
      );
    }

    const updateData = {
      status,
      ...(trackingNumber && { trackingNumber }),
      ...(shipping_name && { shipping_name }),
      ...(status === 'SHIPPED' && { 
        shippedAt: new Date(),
        trackingNumber: trackingNumber || existingOrder.trackingNumber,
        shipping_name: shipping_name || existingOrder.shipping_name
      }),
      ...(status === 'COMPLETED' && { completedAt: new Date() })
    };

    if (status === 'SHIPPED' && !updateData.trackingNumber) {
      throw new ResponseError(400, 'Tracking number is required for SHIPPED status');
    }

    if (status === 'SHIPPED' && !updateData.shipping_name

    ) {
      throw new ResponseError(400, 'Shipping carrier name is required for SHIPPED status');
    }

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: updateData,
      include: {
        user: true,
        items: {
          include: {
            product: {
              select: {
                name: true,
                imageUrl: true
              }
            }
          }
        }
      }
    });

    if (['SHIPPED', 'COMPLETED'].includes(status)) {
      await sendOrderNotification(updatedOrder);
    }

    return updatedOrder;
  });
};

const deleteOrderAdmin = async (orderId) => {
  return await prismaClient.$transaction(async (prisma) => {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true
      }
    });

    if (!order) {
      throw new ResponseError(404, 'Order not found');
    }

    if (order.status !== 'CANCELLED') {
      await Promise.all(
        order.items.map(item => 
          prisma.product.update({
            where: { id: item.productId },
            data: { 
              stock: { increment: item.quantity } 
            }
          })
        )
      );
    }

    await prisma.orderItem.deleteMany({
      where: { orderId }
    });

    await prisma.paymentLog.deleteMany({
      where: { orderId }
    });

    return await prisma.order.delete({
      where: { id: orderId }
    });
  });
};

const trackShipping = async (courier, trackingNumber) => {
  try {
    const normalizedCourier = courier.toLowerCase().trim();
    
    const courierMap = {
      'jne': 'jne',
      'tiki': 'tiki',
      'pos': 'pos',
      'jnt': 'jnt',
      'sicepat': 'sicepat',
      'ninja': 'ninja',
      'wahana': 'wahana',
      'lion parcel': 'lion',
      'anteraja': 'anteraja',
      'idexpress': 'ide'
    };

    const apiCourier = courierMap[normalizedCourier] || normalizedCourier;

    // Using Binderbyte API as example
    const response = await axios.get(`https://api.binderbyte.com/v1/track`, {
      params: {
        api_key: process.env.BINDERBYTE_API_KEY,
        courier: apiCourier,
        awb: trackingNumber
      },
      timeout: 5000
    });

    if (response.data.status !== 200 || !response.data.data) {
      throw new ResponseError(404, 'Tracking information not found');
    }

    const trackingData = response.data.data;
    return {
      courier: trackingData.courier || courier,
      trackingNumber: trackingData.awb || trackingNumber,
      status: trackingData.status || 'In Transit',
      history: (trackingData.history || []).map(item => ({
        date: item.date,
        description: item.desc,
        location: item.location
      })),
      estimatedDelivery: trackingData.estimated_delivery || null,
      receiver: trackingData.receiver || null
    };
  } catch (error) {
    console.error('Tracking error:', error);
    if (error.response) {
      throw new ResponseError(error.response.status, error.response.data.message || 'Failed to get tracking information');
    } else if (error.request) {
      throw new ResponseError(503, 'Tracking service unavailable');
    } else {
      throw new ResponseError(500, 'Failed to get tracking information');
    }
  }
};


const completeOrder = async (userId, orderId) => {
  return await prismaClient.$transaction(async (prisma) => {
    // 1. Verify the order exists and belongs to the user
    const order = await prisma.order.findUnique({
      where: {
        id: orderId,
        userId: userId
      },
      include: {
        items: true
      }
    });

    if (!order) {
      throw new ResponseError(404, 'Order not found');
    }

    // 2. Validate order can be completed (must be SHIPPED status)
    if (order.status !== 'SHIPPED') {
      throw new ResponseError(400, `Order cannot be completed from current status: ${order.status}`);
    }

    // 3. Update order status to COMPLETED
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date()
      },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true
              }
            }
          }
        }
      }
    });

    // 4. Send notification (optional)
    await sendOrderNotification(updatedOrder);

    return updatedOrder;
  });
};

async function sendOrderNotification(order) {
  try {
    // Implement your notification logic here (email, push notification, etc.)
    console.log(`Notification sent for order ${order.id}`);
    console.log('Notification details:', {
      status: order.status,
      trackingNumber: order.trackingNumber,
      customerEmail: order.user.email
    });
  } catch (error) {
    console.error('Failed to send notification:', error);
  }
}

export default {
  getOrderList,
  getOrderDetail,
  updateOrderAdmin,
  deleteOrderAdmin,
  trackShipping,
  completeOrder
};