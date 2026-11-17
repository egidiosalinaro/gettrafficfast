"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface BusinessDescriptionFormProps {
  initialDescription: string;
}

export function BusinessDescriptionForm({ initialDescription }: BusinessDescriptionFormProps) {
  const [description, setDescription] = useState(initialDescription);
  const [descriptionLength, setDescriptionLength] = useState(initialDescription.length);

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setDescription(value);
    setDescriptionLength(value.length);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="description">Description</Label>
      <div className="relative">
        <Textarea
          id="description"
          name="description"
          value={description}
          onChange={handleDescriptionChange}
          maxLength={1000}
          rows={6}
          className="pr-16"
        />
        <div className="absolute bottom-2 right-2 text-xs text-muted-foreground">
          {descriptionLength}/1000 characters
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        A brief description of what your business is about
      </p>
    </div>
  );
}
