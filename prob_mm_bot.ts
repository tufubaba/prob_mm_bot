import { createClobClient, OrderSide, LimitTimeInForce } from '@prob/clob';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { bsc } from 'viem/chains'; // 根据实际链修改
import * as dotenv from 'dotenv';

dotenv.config();

const requireEnv = (key: string): string => {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required env var: ${key}`);
    }
    return value;
};

// --- 配置参数 ---
const CONFIG = {
    PRIVATE_KEY: requireEnv('PRIVATE_KEY') as `0x${string}`,
    BASE_URL: 'https://api.probable.markets/public/api/v1',
    TOKEN_IDS: (() => {
        const raw = process.env.TOKEN_IDS || process.env.TOKEN_ID;
        if (!raw) {
            throw new Error('Missing required env var: TOKEN_IDS or TOKEN_ID');
        }
        return raw
            .split(',')
            .map(tokenId => tokenId.trim())
            .filter(tokenId => tokenId.length > 0);
    })(),
    TOKEN_SYMBOLS: (() => {
        const raw = process.env.TOKEN_SYMBOLS;
        if (!raw) return [];
        return raw
            .split(',')
            .map(symbol => symbol.trim())
            .filter(symbol => symbol.length > 0);
    })(),
    POLL_INTERVAL: 1000,
    ORDER_SIZE: Number(requireEnv('ORDER_SIZE')),
    TICK_JITTER_MS: 100,
};

enum BotState {
    IDLE = 'IDLE',
    BUYING = 'BUYING',
    SELLING = 'SELLING'
}

type TokenConfig = {
    tokenId: string;
    orderSize: number;
    symbol?: string;
};

type TokenSnapshot = {
    tokenId: string;
    symbol?: string;
    state: BotState;
    bestBid: number;
    bestAsk: number;
    inventory: number;
    activeOrderId: string | null;
    note: string;
};

class TokenInstance {
    private state: BotState = BotState.IDLE;
    private activeOrderId: string | null = null;
    private inventory: number = 0;
    private lastOrderSide: OrderSide | null = null;
    private lastBuyPrice: number | null = null;
    private bestBid: number = 0;
    private bestAsk: number = 0;
    private note: string = '';

    constructor(private manager: BotManager, private client: any, public config: TokenConfig) {}

    async tick() {
        this.note = '';
        const orderbook = await this.client.getOrderBook({ tokenId: this.config.tokenId });
        this.bestBid = this.getBestPrice(orderbook.bids, 'bid');
        this.bestAsk = this.getBestPrice(orderbook.asks, 'ask');

        if (!this.bestBid || !this.bestAsk) return;

        switch (this.state) {
            case BotState.IDLE:
                await this.placeBuy(this.bestBid, this.config.orderSize);
                break;
            case BotState.BUYING:
                await this.monitorOrder(this.bestBid, this.bestAsk, OrderSide.Buy);
                break;
            case BotState.SELLING:
                await this.monitorOrder(this.bestBid, this.bestAsk, OrderSide.Sell);
                break;
        }
    }

    getSnapshot(): TokenSnapshot {
        return {
            tokenId: this.config.tokenId,
            symbol: this.config.symbol,
            state: this.state,
            bestBid: this.bestBid,
            bestAsk: this.bestAsk,
            inventory: this.inventory,
            activeOrderId: this.activeOrderId,
            note: this.note,
        };
    }

    handleError(error: any) {
        const errMsg = error?.responseBody?.error?.message || error?.message || String(error);
        if (errMsg.includes('Insufficient CTF token balance')) {
            this.note = '等待结算';
            return;
        }
        this.note = errMsg;
    }

    private getBestPrice(orders: Array<{ price?: string }>, side: 'bid' | 'ask'): number {
        if (!orders || orders.length === 0) return 0;
        const prices = orders
            .map(order => parseFloat(order?.price || '0'))
            .filter(price => Number.isFinite(price) && price > 0);

        if (prices.length === 0) return 0;

        return side === 'bid' ? Math.max(...prices) : Math.min(...prices);
    }

    /**
     * 初始挂买单
     */
    private async placeBuy(price: number, size: number) {
        const order = await this.client.createLimitOrder({
            tokenId: this.config.tokenId,
            price: price,
            size: size,
            side: OrderSide.Buy,
            timeInForce: LimitTimeInForce.GTC,
        });

        this.lastOrderSide = OrderSide.Buy;
        const { orderId } = await this.client.postOrder(order);
        this.activeOrderId = orderId;
        this.state = BotState.BUYING;
    }

    /**
     * 核心监控逻辑：处理价格变化与成交状态
     */
    private async monitorOrder(bestBid: number, bestAsk: number, side: OrderSide) {
        if (!this.activeOrderId) return;

        const order = await this.client.getOrder({
            orderId: this.activeOrderId,
            tokenId: this.config.tokenId
        });

        const targetPrice = side === OrderSide.Buy ? bestBid : bestAsk;
        const currentOrderPrice = parseFloat(order.price);
        const executedQty = parseFloat(order.executedQty || '0');
        const origQty = parseFloat(order.origQty || '0');
        const remainingQty = Math.max(0, origQty - executedQty);

        this.inventory = executedQty;

        // 1. 完全成交情况
        if (order.status === 'FILLED') {
            if (side === OrderSide.Buy) {
                this.lastBuyPrice = currentOrderPrice;
                await this.switchToSelling(bestAsk);
            } else {
                if (this.lastBuyPrice !== null) {
                    const profit = (currentOrderPrice - this.lastBuyPrice) * executedQty;
                    this.manager.addProfit(profit);
                }
                this.inventory = 0;
                this.lastBuyPrice = null;
                this.state = BotState.IDLE;
                this.activeOrderId = null;
            }
            return;
        }

        // 2. 价格发生变化
        if (currentOrderPrice !== targetPrice) {
            await this.client.cancelOrder({ orderId: this.activeOrderId, tokenId: this.config.tokenId });
            this.activeOrderId = null;

            if (side === OrderSide.Buy) {
                // 买单价格变了：如果有部分成交，先去卖已有的；没成交则重挂买单
                if (executedQty > 0) {
                    if (this.lastBuyPrice === null) {
                        this.lastBuyPrice = currentOrderPrice;
                    }
                    await this.switchToSelling(bestAsk);
                } else {
                    await this.placeBuy(bestBid, this.config.orderSize);
                }
            } else {
                // 卖单价格变了：对已成交部分挂反向单
                if (executedQty > 0) {
                    await this.placeBuy(bestBid, executedQty);
                } else {
                    await this.switchToSelling(bestAsk, remainingQty);
                }
            }
        } 
        // 3. 价格没变，且未完全成交 -> 继续等待（Do nothing, next tick will check again）
        else {
            // console.log(`[${this.state}] Waiting for fill... Price: ${currentOrderPrice}, Filled: ${filledAmount}`);
        }
    }

    /**
     * 切换到卖出状态
     */
    private async switchToSelling(price: number, size?: number) {
        const sellSize = size ?? this.inventory;
        if (sellSize <= 0) {
            this.state = BotState.IDLE;
            return;
        }

        const order = await this.client.createLimitOrder({
            tokenId: this.config.tokenId,
            price: price,
            size: sellSize,
            side: OrderSide.Sell,
            timeInForce: LimitTimeInForce.GTC,
        });

        this.lastOrderSide = OrderSide.Sell;
        const { orderId } = await this.client.postOrder(order);
        this.activeOrderId = orderId;
        this.state = BotState.SELLING;
    }
}

class BotManager {
    private client: any;
    private instances: TokenInstance[] = [];
    private totalProfit: number = 0;
    private loopCount: number = 0;

    async start() {
        const account = privateKeyToAccount(CONFIG.PRIVATE_KEY as `0x${string}`);
        const wallet = createWalletClient({
            chain: bsc,
            transport: http(),
            account,
        });

        this.client = createClobClient({
            baseUrl: CONFIG.BASE_URL,
            chainId: bsc.id,
            wallet,
        });

        await this.client.generateApiKey();

        this.instances = CONFIG.TOKEN_IDS.map((tokenId, index) => {
            const symbol = CONFIG.TOKEN_SYMBOLS[index];
            return new TokenInstance(this, this.client, {
                tokenId,
                orderSize: CONFIG.ORDER_SIZE,
                symbol,
            });
        });

        while (true) {
            for (const instance of this.instances) {
                try {
                    await instance.tick();
                } catch (error: any) {
                    instance.handleError(error);
                }
                await this.sleep(CONFIG.TICK_JITTER_MS);
            }
            this.loopCount += 1;
            this.renderDashboard();
            await this.sleep(CONFIG.POLL_INTERVAL);
        }
    }

    addProfit(amount: number) {
        if (!Number.isFinite(amount)) return;
        this.totalProfit += amount;
    }

    private renderDashboard() {
        process.stdout.write('\x1b[2J\x1b[0;0H');
        const profitValue = this.totalProfit;
        const profitText = `${profitValue >= 0 ? '+' : ''}${profitValue.toFixed(2)} USDT`;
        const profitColor =
            profitValue > 0 ? '\x1b[32m' : profitValue < 0 ? '\x1b[31m' : '\x1b[0m';
        const profitLabel = `${profitColor}${profitText}\x1b[0m`;
        const header =
            `Prob Market Maker Bot | Total Tokens: ${this.instances.length} | ${new Date().toLocaleTimeString()} | ` +
            `Profit: ${profitLabel}`;
        const line = '-'.repeat(90);

        console.log(header);
        console.log(line);
        console.log(
            'Symbol'.padEnd(12) +
                'State'.padEnd(10) +
                'Bid'.padEnd(10) +
                'Ask'.padEnd(10) +
                'Inv'.padEnd(10) +
                'Order'.padEnd(14) +
                'Note'
        );
        console.log(line);

        for (const instance of this.instances) {
            const row = instance.getSnapshot();
            const symbol = row.symbol || row.tokenId.slice(-8);
            const displayOrder = row.activeOrderId ? String(row.activeOrderId) : '-';
            const lineItem =
                symbol.padEnd(12) +
                row.state.padEnd(10) +
                (row.bestBid ? row.bestBid.toFixed(4) : '-').padEnd(10) +
                (row.bestAsk ? row.bestAsk.toFixed(4) : '-').padEnd(10) +
                row.inventory.toFixed(4).padEnd(10) +
                displayOrder.padEnd(14) +
                (row.note || '-');
            console.log(lineItem);
        }

        console.log(line);
        console.log('Ctrl+C to quit.');
    }

    private sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// 运行机器人
const manager = new BotManager();
manager.start();
