"use client";

import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/primitives";
import { SeatSwatch } from "@/components/seat/seat-swatch";

/**
 * The components that need to be poked to be judged: tabs, a dialog, and the
 * one piece of motion in the system.
 */
export function StyleguideInteractive() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Tabs</CardTitle>
        </CardHeader>
        <CardBody>
          <Tabs defaultValue="am">
            <TabsList>
              <TabsTrigger value="am">Morning</TabsTrigger>
              <TabsTrigger value="pm">Afternoon</TabsTrigger>
              <TabsTrigger value="day">Full Day</TabsTrigger>
            </TabsList>
            <TabsContent value="am" className="pt-4 text-sm text-ink-muted">
              09:00–13:30. 41 of 110 bookable desks taken.
            </TabsContent>
            <TabsContent value="pm" className="pt-4 text-sm text-ink-muted">
              13:30–19:00. 38 of 110 bookable desks taken.
            </TabsContent>
            <TabsContent value="day" className="pt-4 text-sm text-ink-muted">
              Both slots on the same desk.
            </TabsContent>
          </Tabs>
          <p className="mt-4 text-xs text-ink-subtle">
            The active tab is marked by a 2px gold underline — one of gold&rsquo;s
            three sanctioned jobs.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dialog & Motion</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="primary">Book C3-04</Button>
            </DialogTrigger>
            <DialogContent
              title="Confirm Your Booking"
              description="Desk C3-04, Zone C, Tuesday morning."
            >
              <div className="flex items-center gap-4">
                <SeatSwatch status="your_booking" code="37" size="lg" />
                <p className="min-w-0 text-sm text-ink-muted">
                  Check in by 11:00 or the desk is automatically released back
                  into the pool.
                </p>
              </div>
            </DialogContent>
          </Dialog>

          <div className="border-t border-hairline pt-4">
            <p className="mb-3 text-xs text-ink-subtle">
              Motion: transform and opacity only, never{" "}
              <code className="seat-code">transition: all</code>, and it stops
              entirely under{" "}
              <code className="seat-code">prefers-reduced-motion</code>.
            </p>
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="inline-flex items-center gap-2 rounded-sm border border-hairline bg-surface px-3 py-2 text-sm text-ink"
            >
              <SeatSwatch status="checked_in" size="sm" />
              Checked in at 09:12
            </motion.div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
