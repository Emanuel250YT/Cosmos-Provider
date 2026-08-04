/** Organism: CustomerManager — `client.customers`. */

import { Routes } from "@/atoms/constants";
import { Customer } from "@/molecules/Customer";
import type { APICustomer, Page, PageQuery } from "@/types/index";
import { BaseManager } from "@/organisms/BaseManager";

export class CustomerManager extends BaseManager {
  /** Data for your own organization (`GET /ramp/me`). */
  async me(): Promise<Customer> {
    const raw = await this.rest.get<APICustomer>(Routes.me());
    return new Customer(this.client, raw);
  }

  /** A child customer by id. */
  async fetch(customerId: string): Promise<Customer> {
    const raw = await this.rest.get<APICustomer>(Routes.customerById(customerId));
    return new Customer(this.client, raw);
  }

  /** Paginated list of your organization's child customers. */
  async list(query: PageQuery = {}): Promise<Page<Customer>> {
    const raw = await this.rest.get<Page<APICustomer>>(Routes.customers(), {
      query: { pageNumber: query.pageNumber, pageSize: query.pageSize },
    });
    return { ...raw, items: (raw.items ?? []).map((c) => new Customer(this.client, c)) };
  }

  /** Advanced search (POST variant with filters/pagination). */
  async search(filters: Record<string, unknown>): Promise<Page<Customer>> {
    const raw = await this.rest.post<Page<APICustomer>>(Routes.customers(), filters);
    return { ...raw, items: (raw.items ?? []).map((c) => new Customer(this.client, c)) };
  }
}
