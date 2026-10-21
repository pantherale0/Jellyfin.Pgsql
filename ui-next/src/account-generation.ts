export class RequestGeneration {
    private value = 0;

    current(): number {
        return this.value;
    }

    begin(): number {
        this.value += 1;
        return this.value;
    }

    invalidate(): void {
        this.value += 1;
    }

    isCurrent(id: number): boolean {
        return id === this.value;
    }
}

export class AccountGeneration extends RequestGeneration { }
