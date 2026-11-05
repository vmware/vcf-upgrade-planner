## Recommended Approach: Detailed Steps

**Summary:** The customer upgrades VCF to 9.1.1 without upgrading the existing DSM 2.2.3 instance. After the VCF upgrade, they move the existing database to a new VCF-native DSM 9.1.1 deployment by using PostgreSQL replication (Disaster Recovery).

**Starting point:** VCF 5.2 with Aria Automation, which is integrated with DSM 2.2.3. DSM runs one PostgreSQL 16.8 database (`16.8+vmware.v2.2.1`).

**Prerequisite:** Confirm that the customer is willing to adopt the new VCF Automation (VCFA) native tenancy model on VCFA 9.1.1. This approach only works with that model, because DSM integrates with VCFA through native tenant organizations only. Legacy tenants that are moved into VM Apps organizations can't be used for the DSM database migration.

**Assumption:** The rest of these steps assume that the customer adopts the VCFA native tenancy model after the upgrade to VCF 9.1.1.

> **Downtime:** Application downtime starts when client connections to the existing database are blocked (step 10) and ends when the applications are switched to the new primary (step 12). Plan a maintenance window for this.

### Phase 1: Before the VCF Upgrade

> **Recommended (optional):** Before you upgrade VCF, enable backups on the existing PostgreSQL database if they aren't enabled already. This isn't required for the migration, but it gives you a recovery point if something goes wrong during the upgrade or the migration.

1. Enable replication on the existing PostgreSQL database (`16.8+vmware.v2.2.1`) through [Aria Automation](https://cormachogan.com/2025/03/14/vmware-data-services-manager-2-2-1-and-aria-automation-enhancements/), and note the replication connection string. **Important:** Only enable replication. Don't create a replica at this stage.
2. As the DSM admin, [get the CA certificate](https://techdocs.broadcom.com/us/en/vmware-cis/dsm/data-services-manager/2-2/getting-started-with-vmware-data-services-manager/using-trusted-certificates-in-data-services-manager/establish-secure-connection-to-a-database-cluster-in-vmware-data-services-manager.html#GUID-5AF63F06-5C32-428C-A10A-B813067A1A22-en:~:text=Search%20this%20product-,Get%20the%20CA%20by%20Using%20the%20VMware%20Data%20Services%20Manager%20UI,-You%20can%20download) of the existing PostgreSQL database from the VMware Data Services Manager UI. The read replica created after the upgrade needs this certificate to trust the source database.
3. Upgrade VCF 5.2 to VCF 9.1.1 without upgrading DSM.

### Phase 2: After the Upgrade to VCF 9.1.1, Set Up the New DSM

4. [Install a new DSM 9.1.1 as a VCF-native deployment.](https://techdocs.broadcom.com/us/en/vmware-cis/dsm/data-services-manager/9-1/using-vmware-data-services-manager-with-vmware-cloud-foundation/using-as-a-provider/managing-data-services-manager-regions-in-vcf-automation-911-and-later/configure-vmware-data-services-manager-in-vmware-cloud-foundation-automation.html)
5. As the VCFA provider admin, [assign a dedicated provider organization](https://techdocs.broadcom.com/us/en/vmware-cis/dsm/data-services-manager/9-1/using-vmware-data-services-manager-with-vmware-cloud-foundation/using-as-a-provider/managing-data-services-manager-regions-in-vcf-automation-911-and-later/assign-a-dedicated-dsm-provider-organization.html).
6. Log in to the standalone DSM UI as the DSM admin, and [enable the PostgreSQL 16.14 9.1.1 data service version](https://techdocs.broadcom.com/us/en/vmware-cis/dsm/data-services-manager/9-1/getting-started-with-vmware-data-services-manager/administering-vmware-data-services-manager/activate-data-services-in-vmware-data-services-manager.html).
7. As the VCFA provider admin, [create a data services policy (DSP)](https://techdocs.broadcom.com/us/en/vmware-cis/dsm/data-services-manager/9-1/using-vmware-data-services-manager-with-vmware-cloud-foundation/using-as-a-provider/create-a-data-service-policy.html) for PostgreSQL.

### Phase 3: Migrate the Database

8. As a tenant admin or user, [create a PostgreSQL read replica instance using version 16.14 via Data Services Manager in VCF Automation](https://techdocs.broadcom.com/us/en/vmware-cis/dsm/data-services-manager/9-1/using-vmware-data-services-manager-with-vmware-cloud-foundation/using-as-a-tenant/multisite-deployment-enabling-disaster-recovery-for-postgresql-databases-using-data-services-manager-in-vcf-automation/create-the-read-replica-instance-using-data-services-manager-in-vcf-automation.html). In the **Data Availability and Protection** step:
   1. Change the scheme of the replication user connection string that you noted in step 1 from <code><strong>postgres</strong>://&lt;connection-string&gt;</code> to <code><strong>postgresql</strong>://&lt;connection-string&gt;</code>.
   2. Under **Certificate Trust Source**, select **Custom CA**.
   3. Paste the PEM-formatted CA certificate of the primary database from step 2.
9. Confirm that the read replica is in sync with the primary and that replication lag is close to zero. You can check the replication lag on the primary instance in the DSM 2.2.3 standalone UI, on the database's **Summary** page, in the **Data Availability and Remote Replication** section.
10. Block client connections to the existing PostgreSQL database.
11. [Promote the read replica to primary.](https://techdocs.broadcom.com/us/en/vmware-cis/dsm/data-services-manager/9-1/using-vmware-data-services-manager-with-vmware-cloud-foundation/using-as-a-tenant/multisite-deployment-enabling-disaster-recovery-for-postgresql-databases-using-data-services-manager-in-vcf-automation/promote-a-read-replica-to-primary-using-data-services-manager-in-vcf-automation.html)
12. Switch the application connections from the old instance to the new primary database instance.
13. Verify that the applications can connect and work against the new database.

### Phase 4: Cleanup

Do these steps only after the new database has been validated.

14. Delete the old PostgreSQL database by using the DSM API.
15. Delete the old DSM 2.2.3 instance from vCenter.
